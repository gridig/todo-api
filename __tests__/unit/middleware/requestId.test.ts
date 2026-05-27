import { jest } from '@jest/globals';
import { requestIdMiddleware } from '@/middleware/requestId.js';

describe('RequestId Middleware', () => {
  let req: any;
  let res: any;
  let next: jest.Mock;

  beforeEach(() => {
    req = {
      headers: {},
      method: 'GET',
      path: '/test',
    };
    res = {
      setHeader: jest.fn(),
    };
    next = jest.fn();
  });

  it('should use x-request-id header when provided as string', () => {
    req.headers['x-request-id'] = 'custom-request-id';

    requestIdMiddleware(req, res, next);

    expect(req.id).toBe('custom-request-id');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'custom-request-id');
    expect(next).toHaveBeenCalled();
  });

  it('should use x-correlation-id header when x-request-id is not provided', () => {
    req.headers['x-correlation-id'] = 'correlation-id';

    requestIdMiddleware(req, res, next);

    expect(req.id).toBe('correlation-id');
    expect(next).toHaveBeenCalled();
  });

  it('should generate UUID when no request ID headers are provided', () => {
    requestIdMiddleware(req, res, next);

    expect(req.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(next).toHaveBeenCalled();
  });

  it('should use first element when x-request-id is an array', () => {
    req.headers['x-request-id'] = ['first-id', 'second-id'];

    requestIdMiddleware(req, res, next);

    expect(req.id).toBe('first-id');
    expect(next).toHaveBeenCalled();
  });

  it('should generate UUID when x-request-id is an empty array', () => {
    req.headers['x-request-id'] = [];

    requestIdMiddleware(req, res, next);

    expect(req.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(next).toHaveBeenCalled();
  });

  it('should create child logger with request context', () => {
    requestIdMiddleware(req, res, next);

    expect(req.log).toBeDefined();
    expect(req.log.info).toBeDefined();
    expect(req.log.error).toBeDefined();
  });

  describe('input validation', () => {
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    it('falls back to a UUID when x-request-id contains forbidden characters', () => {
      req.headers['x-request-id'] = 'evil\nLog-Injection: x';

      requestIdMiddleware(req, res, next);

      expect(req.id).toMatch(UUID_PATTERN);
      expect(res.setHeader).toHaveBeenCalledWith(
        'X-Request-ID',
        expect.stringMatching(UUID_PATTERN),
      );
    });

    it('falls back to a UUID when x-request-id exceeds 64 characters', () => {
      req.headers['x-request-id'] = 'a'.repeat(65);

      requestIdMiddleware(req, res, next);

      expect(req.id).toMatch(UUID_PATTERN);
    });

    it('accepts an x-request-id of exactly 64 characters', () => {
      const id = 'a'.repeat(64);
      req.headers['x-request-id'] = id;

      requestIdMiddleware(req, res, next);

      expect(req.id).toBe(id);
    });

    it('falls back to a UUID when x-request-id is empty', () => {
      req.headers['x-request-id'] = '';

      requestIdMiddleware(req, res, next);

      expect(req.id).toMatch(UUID_PATTERN);
    });

    it('does not echo an unsafe x-correlation-id header', () => {
      req.headers['x-correlation-id'] = 'evil value with spaces';

      requestIdMiddleware(req, res, next);

      // X-Correlation-ID is set only when the inbound value passes validation.
      const calls = (res.setHeader as jest.Mock).mock.calls;
      const correlationCall = calls.find((call) => call[0] === 'X-Correlation-ID');
      expect(correlationCall).toBeUndefined();
    });
  });
});
