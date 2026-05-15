import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../app.js';
import { createTestUser, disconnectTestDB } from '../helpers/testSetup.js';
import UserService from '../../models/User.js';

describe('CORS Integration', () => {
  let app: Application;
  let authToken: string;

  beforeAll(async () => {
    app = createApp();
    ({ authToken } = await createTestUser());
  });

  afterAll(async () => {
    await UserService.deleteMany();
    await disconnectTestDB();
  });

  describe('Preflight Requests', () => {
    it('should handle OPTIONS preflight request with proper headers', async () => {
      const response = await request(app)
        .options('/todos')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:3000'
      );
      expect(response.headers['access-control-allow-methods']).toContain('GET');
    });
  });

  describe('CORS Headers', () => {
    it('should include CORS headers in authenticated response', async () => {
      const response = await request(app)
        .get('/todos')
        .set('Origin', 'http://localhost:3000')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:3000'
      );
    });

    it('should include CORS headers in error response', async () => {
      const response = await request(app)
        .post('/auth/login')
        .set('Origin', 'http://localhost:3000')
        .send({ email: 'invalid@test.com', password: 'wrong' });

      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:3000'
      );
    });
  });

  describe('Origin Validation', () => {
    it('should allow requests from allowed origins', async () => {
      const response = await request(app)
        .get('/health')
        .set('Origin', 'http://localhost:3000');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:3000'
      );
    });

    it('should reject requests from disallowed origins', async () => {
      const response = await request(app)
        .get('/health')
        .set('Origin', 'http://malicious-site.com');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should allow requests with no origin (mobile apps, Postman)', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
    });
  });
});
