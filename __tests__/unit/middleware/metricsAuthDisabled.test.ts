import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// The unset-METRICS_TOKEN branch: metricsAuthMiddleware hoists the expected
// token at module load, and with none configured it passes every request
// through — /metrics is deliberately public in that configuration (production
// refuses to boot without a token; this covers dev/staging behavior).
jest.unstable_mockModule('@/config/env.js', () => ({
  env: { METRICS_TOKEN: undefined, NODE_ENV: 'test' },
}));

const { metricsAuthMiddleware } = await import('@/middleware/metrics.js');

describe('metricsAuthMiddleware with METRICS_TOKEN unset', () => {
  it('passes requests through without any auth check', () => {
    const req = { headers: {} } as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;
    const next = jest.fn();

    metricsAuthMiddleware(req, res, next as NextFunction);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
