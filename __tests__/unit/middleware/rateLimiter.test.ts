import { jest } from '@jest/globals';
import { logRateLimitHandler } from '../../../middleware/rateLimiter.js';

describe('Rate Limiter Middleware', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let req: any;
  let res: any;
  let next: jest.Mock;
  let options: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    req = {
      userId: 'test-user',
      ip: '127.0.0.1',
      path: '/test',
      get: jest.fn().mockReturnValue('test-agent'),
      log: {
        warn: jest.fn(),
      },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    options = {
      message: { error: 'Rate limit exceeded' },
    };
  });

  describe('logRateLimitHandler', () => {
    it.each(['auth', 'write', 'read', 'global', 'register'])(
      'should log and return 429 for %s rate limit',
      (type) => {
        const handler = logRateLimitHandler(type);

        handler(req, res, next, options);

        expect(req.log.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'test-user',
            ip: '127.0.0.1',
            path: '/test',
            limitType: type,
            userAgent: 'test-agent',
          }),
          `Rate limit exceeded - ${type}`
        );
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith(options.message);
      }
    );

    it('should use module logger when req.log is not available', () => {
      delete req.log;

      const handler = logRateLimitHandler('auth');

      expect(() => handler(req, res, next, options)).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(options.message);
    });
  });
});
