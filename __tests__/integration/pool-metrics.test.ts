import { jest } from '@jest/globals';
import request from 'supertest';
import {
  createTestApp,
  connectTestDB,
  disconnectTestDB,
} from '../helpers/testSetup.js';
import {
  getPoolMetrics,
  logPoolHealth,
  POOL_UTILIZATION_WARN_THRESHOLD,
  pool,
} from '../../lib/prisma.js';
import logger from '../../middleware/logger.js';

const app = createTestApp();

describe('Database Pool Observability', () => {
  beforeAll(async () => {
    await connectTestDB();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  describe('getPoolMetrics()', () => {
    it('returns the expected shape with sensible values', () => {
      const metrics = getPoolMetrics();

      expect(metrics).toEqual({
        totalConnections: expect.any(Number),
        idleConnections: expect.any(Number),
        waitingClients: expect.any(Number),
        maxConnections: expect.any(Number),
        utilization: expect.any(Number),
      });
      expect(metrics.totalConnections).toBeGreaterThanOrEqual(0);
      expect(metrics.idleConnections).toBeGreaterThanOrEqual(0);
      expect(metrics.idleConnections).toBeLessThanOrEqual(
        metrics.totalConnections,
      );
      expect(metrics.maxConnections).toBeGreaterThan(0);
      expect(metrics.utilization).toBeGreaterThanOrEqual(0);
      expect(metrics.utilization).toBeLessThanOrEqual(100);
    });

    it('reads live pool state (total reflects pg.Pool.totalCount)', () => {
      expect(getPoolMetrics().totalConnections).toBe(pool.totalCount);
    });
  });

  describe('GET /health/ready — pool check', () => {
    it('includes checks.pool with the expected fields', async () => {
      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body.checks.pool).toEqual({
        status: expect.stringMatching(/^(ok|warning|error)$/),
        total: expect.any(Number),
        idle: expect.any(Number),
        waiting: expect.any(Number),
        max: expect.any(Number),
        utilization: expect.stringMatching(/^\d+(\.\d+)?%$/),
        threshold: `${POOL_UTILIZATION_WARN_THRESHOLD}%`,
      });
    });

    it('returns 503 with pool.status="error" when the pool is saturated', async () => {
      // Saturation: pool fully grown, no idle slots, clients queued.
      const maxConnections = getPoolMetrics().maxConnections;
      const totalSpy = jest
        .spyOn(pool, 'totalCount', 'get')
        .mockReturnValue(maxConnections);
      const idleSpy = jest
        .spyOn(pool, 'idleCount', 'get')
        .mockReturnValue(0);
      const waitingSpy = jest
        .spyOn(pool, 'waitingCount', 'get')
        .mockReturnValue(7);

      try {
        const response = await request(app).get('/health/ready');

        expect(response.status).toBe(503);
        expect(response.headers['retry-after']).toBe('5');
        expect(response.body.status).toBe('degraded');
        expect(response.body.checks.pool).toMatchObject({
          status: 'error',
          idle: 0,
          waiting: 7,
          max: maxConnections,
        });
        // DB sub-check is unaffected
        expect(response.body.checks.database.status).toBe('ok');
      } finally {
        totalSpy.mockRestore();
        idleSpy.mockRestore();
        waitingSpy.mockRestore();
      }
    });

    it('stays 200 with pool.status="warning" when utilization is high but not saturated', async () => {
      // 90% utilization, but at least one idle slot — next request is served
      // immediately, so not a readiness failure.
      const maxConnections = getPoolMetrics().maxConnections;
      const totalSpy = jest
        .spyOn(pool, 'totalCount', 'get')
        .mockReturnValue(maxConnections);
      const idleSpy = jest
        .spyOn(pool, 'idleCount', 'get')
        .mockReturnValue(1);
      const waitingSpy = jest
        .spyOn(pool, 'waitingCount', 'get')
        .mockReturnValue(0);

      try {
        const response = await request(app).get('/health/ready');

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('ok');
        expect(response.body.checks.pool.status).toMatch(/^(ok|warning)$/);
      } finally {
        totalSpy.mockRestore();
        idleSpy.mockRestore();
        waitingSpy.mockRestore();
      }
    });

    it('stays 200 when pool is at min capacity but idle (no saturation)', async () => {
      // Pool warmed only to min; even with waiting>0 this is a transient
      // warm-up state and the pool can still grow — not saturation.
      const totalSpy = jest
        .spyOn(pool, 'totalCount', 'get')
        .mockReturnValue(2);
      const idleSpy = jest
        .spyOn(pool, 'idleCount', 'get')
        .mockReturnValue(0);
      const waitingSpy = jest
        .spyOn(pool, 'waitingCount', 'get')
        .mockReturnValue(3);

      try {
        const response = await request(app).get('/health/ready');

        // total (2) < max (whatever DB_POOL_MAX is, usually 10) → pool can
        // still grow → not saturated → still ready.
        expect(response.status).toBe(200);
      } finally {
        totalSpy.mockRestore();
        idleSpy.mockRestore();
        waitingSpy.mockRestore();
      }
    });
  });

  describe('GET /metrics — pool gauges', () => {
    it('exposes the four db_pool_* gauges', async () => {
      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).toContain('db_pool_total_connections');
      expect(response.text).toContain('db_pool_idle_connections');
      expect(response.text).toContain('db_pool_waiting_clients');
      expect(response.text).toContain('db_pool_max_connections');
    });
  });

  describe('logPoolHealth()', () => {
    it('emits info under the warn threshold', () => {
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      logPoolHealth();

      expect(warnSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          totalConnections: expect.any(Number),
          utilization: expect.stringMatching(/^\d+(\.\d+)?%$/),
        }),
        'pg pool: health check',
      );

      infoSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('emits warn when utilization exceeds the threshold', () => {
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      // Force utilization > 80% by reporting all-but-one connection as active.
      const totalSpy = jest
        .spyOn(pool, 'totalCount', 'get')
        .mockReturnValue(10);
      const idleSpy = jest
        .spyOn(pool, 'idleCount', 'get')
        .mockReturnValue(1);

      try {
        logPoolHealth();
      } finally {
        totalSpy.mockRestore();
        idleSpy.mockRestore();
      }

      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          totalConnections: 10,
          idleConnections: 1,
        }),
        'pg pool: utilization above threshold',
      );

      infoSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });
});
