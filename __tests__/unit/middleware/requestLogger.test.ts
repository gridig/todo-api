import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { requestLoggerMiddleware } from '@/middleware/requestLogger.js';

describe('Request Logger Middleware', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let req: any;
  let res: any;
  let next: jest.Mock;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    req = {
      log: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      },
      get: jest.fn().mockReturnValue('test-user-agent'),
    };
    res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      _loggerWrapped: false,
    });
    next = jest.fn();
  });

  it('should skip if already wrapped', () => {
    res._loggerWrapped = true;

    requestLoggerMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();

    res.emit('finish');
    expect(req.log.debug).not.toHaveBeenCalled();
  });

  it('should log at debug level for 2xx responses', () => {
    res.statusCode = 200;
    requestLoggerMiddleware(req, res, next);

    expect(res._loggerWrapped).toBe(true);
    expect(next).toHaveBeenCalled();

    res.emit('finish');

    expect(req.log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 200,
        duration: expect.any(String),
        userAgent: 'test-user-agent',
      }),
      'Request completed',
    );
    expect(req.log.info).not.toHaveBeenCalledWith(expect.anything(), 'Request completed');
    expect(req.log.warn).not.toHaveBeenCalledWith(expect.anything(), 'Request completed');
    expect(req.log.error).not.toHaveBeenCalledWith(expect.anything(), 'Request completed');
  });

  it('should log at warn level for 4xx responses', () => {
    res.statusCode = 404;
    requestLoggerMiddleware(req, res, next);
    res.emit('finish');

    expect(req.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        userAgent: 'test-user-agent',
      }),
      'Request completed',
    );
    expect(req.log.info).not.toHaveBeenCalledWith(expect.anything(), 'Request completed');
    expect(req.log.error).not.toHaveBeenCalledWith(expect.anything(), 'Request completed');
  });

  it('should log at error level for 500 responses', () => {
    res.statusCode = 500;
    requestLoggerMiddleware(req, res, next);
    res.emit('finish');

    expect(req.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        userAgent: 'test-user-agent',
      }),
      'Request completed',
    );
    expect(req.log.info).not.toHaveBeenCalledWith(expect.anything(), 'Request completed');
    expect(req.log.warn).not.toHaveBeenCalledWith(expect.anything(), 'Request completed');
  });

  it('should log at error level for 502 responses', () => {
    res.statusCode = 502;
    requestLoggerMiddleware(req, res, next);
    res.emit('finish');

    expect(req.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 502 }),
      'Request completed',
    );
  });

  it('should log at error level for 504 responses', () => {
    res.statusCode = 504;
    requestLoggerMiddleware(req, res, next);
    res.emit('finish');

    expect(req.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 504 }),
      'Request completed',
    );
  });

  it('should log at warn level for 503 responses (deliberate backpressure, not a server fault)', () => {
    res.statusCode = 503;
    requestLoggerMiddleware(req, res, next);
    res.emit('finish');

    expect(req.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 503,
        userAgent: 'test-user-agent',
      }),
      'Request completed',
    );
    expect(req.log.error).not.toHaveBeenCalledWith(expect.anything(), 'Request completed');
  });

  it('should not log twice when middleware runs twice on the same response', () => {
    requestLoggerMiddleware(req, res, next);
    requestLoggerMiddleware(req, res, next);

    res.emit('finish');

    expect(req.log.debug).toHaveBeenCalledTimes(1);
  });

  it('should log incoming request with userAgent in development', () => {
    requestLoggerMiddleware(req, res, next);

    expect(req.log.info).toHaveBeenCalledWith({ userAgent: 'test-user-agent' }, 'Incoming request');
  });
});
