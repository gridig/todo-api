import request from 'supertest';
import { createTestApp } from '../helpers/testSetup.js';

const app = createTestApp();

describe('Echo Endpoint', () => {
  describe('GET /echo', () => {
    it('should return 200 with static JSON', async () => {
      const response = await request(app).get('/echo');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'echo' });
    });

    it('should include X-Request-ID header', async () => {
      const response = await request(app).get('/echo');

      expect(response.headers['x-request-id']).toBeDefined();
    });

    it('should preserve a provided X-Request-ID', async () => {
      const customId = '00000000-0000-0000-0000-000000000099';
      const response = await request(app)
        .get('/echo')
        .set('X-Request-ID', customId);

      expect(response.headers['x-request-id']).toBe(customId);
    });

    it('should not be rate limited', async () => {
      const requests = Array.from({ length: 10 }, () =>
        request(app).get('/echo'),
      );
      const responses = await Promise.all(requests);

      responses.forEach((res) => {
        expect(res.status).toBe(200);
      });
    });
  });

  describe('POST /echo', () => {
    it('should echo the request body', async () => {
      const body = { foo: 'bar', num: 42 };
      const response = await request(app)
        .post('/echo')
        .send(body);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(body);
    });

    it('should return empty object when no body is sent', async () => {
      const response = await request(app)
        .post('/echo')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    it('rejects bodies exceeding BODY_LIMIT (16kb default) with 413', async () => {
      // Previously /echo used express.json() without `limit`, defaulting to
      // 100kb — bypassing the configured BODY_LIMIT. This test guards the
      // pass-through of env.BODY_LIMIT to express.json() in routes/echo.ts.
      const oversizedPayload = { x: 'A'.repeat(20_000) }; // ~20kb > 16kb default

      const response = await request(app)
        .post('/echo')
        .set('Content-Type', 'application/json')
        .send(oversizedPayload);

      expect(response.status).toBe(413);
    });
  });
});
