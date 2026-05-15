import { jest } from '@jest/globals';
import { requestIdMiddleware } from '../../../middleware/requestId.js';

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
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Request-ID',
      'custom-request-id'
    );
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

    expect(req.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
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

    expect(req.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(next).toHaveBeenCalled();
  });

  it('should create child logger with request context', () => {
    requestIdMiddleware(req, res, next);

    expect(req.log).toBeDefined();
    expect(req.log.info).toBeDefined();
    expect(req.log.error).toBeDefined();
  });
});
