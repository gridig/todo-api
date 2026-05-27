import { jest } from '@jest/globals';
import request from 'supertest';
import { createTestApp, connectTestDB, disconnectTestDB } from '../helpers/testSetup.js';
import { probePool } from '../../lib/prisma.js';
import { env } from '../../config/env.js';

const app = createTestApp();
const bearer = `Bearer ${env.METRICS_TOKEN}`;

describe('Health Check Endpoints', () => {
  beforeAll(async () => {
    await connectTestDB();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  describe('GET /health', () => {
    it('should return 200 with liveness status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        version: '1.0.0',
      });
      expect(response.body.timestamp).toBeDefined();
      expect(response.body.uptime).toBeGreaterThanOrEqual(0);
      expect(response.body.environment).toBeDefined();
    });
  });

  describe('GET /health/ready (public lean)', () => {
    it('should return 200 with only { status, timestamp } when ready', async () => {
      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        timestamp: expect.any(String),
      });
      // Rich internals must not leak via the public endpoint.
      expect(response.body.checks).toBeUndefined();
      expect(response.body.environment).toBeUndefined();
      expect(response.body.version).toBeUndefined();
    });
  });

  describe('GET /health/ready/detailed (authenticated)', () => {
    it('should return 401 without a bearer token', async () => {
      const response = await request(app).get('/health/ready/detailed');
      expect(response.status).toBe(401);
    });

    it('should return 401 with a wrong-length bearer token', async () => {
      const response = await request(app)
        .get('/health/ready/detailed')
        .set('Authorization', 'Bearer wrong');
      expect(response.status).toBe(401);
    });

    it('should return the rich payload with a valid bearer token', async () => {
      const response = await request(app)
        .get('/health/ready/detailed')
        .set('Authorization', bearer);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        version: '1.0.0',
        checks: {
          database: { status: 'ok', state: 'connected' },
          pool: expect.objectContaining({ status: expect.any(String) }),
          memory: expect.objectContaining({ status: expect.any(String) }),
          cpu: expect.objectContaining({ status: expect.any(String) }),
        },
      });
    });
  });
});

describe('GET /health/ready - Database Failure', () => {
  it('should return 503 with lean body when database is unavailable', async () => {
    const querySpy = jest
      .spyOn(probePool, 'query')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockRejectedValue(new Error('Connection refused') as never) as any;

    try {
      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('30');
      expect(response.body).toEqual({
        status: 'degraded',
        timestamp: expect.any(String),
      });
    } finally {
      querySpy.mockRestore();
    }
  });

  it('should return 503 with rich body on /detailed when database is unavailable', async () => {
    const querySpy = jest
      .spyOn(probePool, 'query')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockRejectedValue(new Error('Connection refused') as never) as any;

    try {
      const response = await request(app)
        .get('/health/ready/detailed')
        .set('Authorization', bearer);

      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('30');
      expect(response.body).toMatchObject({
        status: 'degraded',
        checks: {
          database: { status: 'error', state: 'error' },
        },
      });
    } finally {
      querySpy.mockRestore();
    }
  });
});
