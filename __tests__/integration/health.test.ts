import { jest } from '@jest/globals';
import request from 'supertest';
import {
  createTestApp,
  connectTestDB,
  disconnectTestDB,
} from '../helpers/testSetup.js';
import prisma from '../../lib/prisma.js';

const app = createTestApp();

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

  describe('GET /health/ready', () => {
    it('should return 200 when PostgreSQL is connected', async () => {
      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        version: '1.0.0',
        checks: {
          database: {
            status: 'ok',
            state: 'connected',
          },
        },
      });
    });
  });
});

describe('GET /health/ready - Database Failure', () => {
  it('should return 503 when database is unavailable', async () => {
    // Mock database failure
    const originalExecuteRaw = prisma.$executeRaw;
    prisma.$executeRaw = jest
      .fn<any>()
      .mockRejectedValue(new Error('Connection refused'));

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'degraded',
      checks: {
        database: {
          status: 'error',
          state: 'error',
        },
      },
    });

    // Restore original
    prisma.$executeRaw = originalExecuteRaw;
  });
});
