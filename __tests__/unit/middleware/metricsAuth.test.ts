import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const TOKEN = 'test-metrics-token';

jest.unstable_mockModule('../../../config/env.js', () => ({
  env: { METRICS_TOKEN: TOKEN },
}));

const { metricsAuthMiddleware } = await import('../../../middleware/metrics.js');

describe('metricsAuthMiddleware', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let req: any;
  let res: any;
  let next: jest.Mock;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    req = { headers: {}, query: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
  });

  it('rejects requests with no Authorization header (NO_TOKEN)', () => {
    metricsAuthMiddleware(req as Request, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'NO_TOKEN' }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a wrong token (different length) with INVALID_TOKEN', () => {
    req.headers.authorization = 'Bearer wrong-token';

    metricsAuthMiddleware(req as Request, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'INVALID_TOKEN' }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a same-length wrong token with INVALID_TOKEN (timingSafeEqual path)', () => {
    // Same length as TOKEN ('test-metrics-token' = 18 chars) to exercise the
    // timingSafeEqual branch rather than the length short-circuit.
    expect('xxxxxxxxxxxxxxxxxx'.length).toBe(TOKEN.length);
    req.headers.authorization = 'Bearer xxxxxxxxxxxxxxxxxx';

    metricsAuthMiddleware(req as Request, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'INVALID_TOKEN' }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects the token when supplied via ?token= query string', () => {
    req.query.token = TOKEN;

    metricsAuthMiddleware(req as Request, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'NO_TOKEN' }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts the token via Authorization: Bearer header', () => {
    req.headers.authorization = `Bearer ${TOKEN}`;

    metricsAuthMiddleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
