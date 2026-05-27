import { jest } from '@jest/globals';
import { errorHandler } from '../../../middleware/errorHandler.js';
import {
  AppError,
  TodoNotFoundError,
  DuplicateEmailError,
  ServiceUnavailableError,
} from '../../../errors/index.js';
import type { PrismaError } from '../../../types/index.js';

describe('Error Handler Middleware', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let req: any;
  let res: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let next: jest.Mock;

  beforeEach(() => {
    req = {
      id: 'test-request-id',
      userId: 'test-user-id',
      body: {},
      params: {},
      query: {},
      log: {
        error: jest.fn(),
      },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };
    next = jest.fn();
  });

  describe('AppError handling', () => {
    it('should handle custom AppError instances', () => {
      const error = new TodoNotFoundError();

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'TODO_NOT_FOUND',
            message: 'Todo not found',
          }),
          requestId: 'test-request-id',
        }),
      );
      expect(req.log.error).toHaveBeenCalled();
    });

    it('should handle generic AppError', () => {
      const error = new AppError('Custom error', 400, 'CUSTOM_ERROR', {
        extra: 'info',
      });

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'CUSTOM_ERROR',
            message: 'Custom error',
            details: { extra: 'info' },
          }),
          requestId: 'test-request-id',
        }),
      );
    });

    it('should set Retry-After header on ServiceUnavailableError (default 30s)', () => {
      const error = new ServiceUnavailableError();

      errorHandler(error, req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'SERVICE_UNAVAILABLE',
            details: expect.objectContaining({
              retryable: true,
              retryAfter: 30,
            }),
          }),
        }),
      );
    });

    it('should honor a custom Retry-After value', () => {
      const error = new ServiceUnavailableError(
        'Database temporarily unavailable',
        'DATABASE_UNAVAILABLE',
        120,
      );

      errorHandler(error, req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '120');
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('should NOT set Retry-After on non-503 AppErrors', () => {
      const error = new TodoNotFoundError();

      errorHandler(error, req, res, next);

      expect(res.setHeader).not.toHaveBeenCalledWith('Retry-After', expect.anything());
    });

    it('should handle AppError without details', () => {
      const error = new AppError('No details error', 400, 'NO_DETAILS', null);

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'NO_DETAILS',
          message: 'No details error',
        },
        requestId: 'test-request-id',
      });
      // Verify details is NOT included
      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall.error.details).toBeUndefined();
    });
  });

  describe('Prisma Error Handling', () => {
    it('should handle Prisma P2002 unique constraint violation on email', () => {
      const error = new Error('Unique constraint failed') as PrismaError;
      error.code = 'P2002';
      error.meta = { target: ['email'] };

      errorHandler(error, req, res, next);

      const expected = new DuplicateEmailError();
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: expected.code,
            message: expected.message,
          }),
          requestId: 'test-request-id',
        }),
      );
    });

    it('should handle Prisma P2002 with unknown field', () => {
      const error = new Error('Unique constraint failed') as PrismaError;
      error.code = 'P2002';
      error.meta = { target: ['unknown_field'] };

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'DUPLICATE_VALUE',
            message: 'Unknown_field already exists',
          }),
        }),
      );
    });

    it('should handle Prisma P2002 without meta', () => {
      const error = new Error('Unique constraint failed') as PrismaError;
      error.code = 'P2002';

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'DUPLICATE_VALUE',
            message: 'Field already exists',
          }),
        }),
      );
    });

    it('should handle Prisma P2025 record not found', () => {
      const error = new Error('Record not found') as PrismaError;
      error.code = 'P2025';

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'NOT_FOUND',
            message: 'Record not found',
          }),
          requestId: 'test-request-id',
        }),
      );
    });
  });

  describe('Prisma error classification', () => {
    it.each(['P1001', 'P1002', 'P1008', 'P1017'])(
      'maps transient code %s to 503 DATABASE_UNAVAILABLE with Retry-After: 30',
      (code) => {
        const error = new Error(`Prisma ${code}`) as PrismaError;
        error.code = code;

        errorHandler(error, req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: expect.objectContaining({
              code: 'DATABASE_UNAVAILABLE',
              details: expect.objectContaining({
                retryable: true,
                retryAfter: 30,
              }),
            }),
            requestId: 'test-request-id',
          }),
        );
      },
    );

    it('maps P2024 pool timeout to 503 with short Retry-After: 5', () => {
      const error = new Error('Timed out fetching connection') as PrismaError;
      error.code = 'P2024';

      errorHandler(error, req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'DATABASE_UNAVAILABLE',
            message: 'Database connection pool exhausted',
          }),
        }),
      );
    });

    it('maps P2003 foreign-key violation to 409 ConflictError', () => {
      const error = new Error('FK constraint') as PrismaError;
      error.code = 'P2003';

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'FOREIGN_KEY_CONSTRAINT',
          }),
        }),
      );
    });

    it.each(['P1000', 'P1010'])(
      'maps config-error code %s to 500 INTERNAL_ERROR (not retryable)',
      (code) => {
        const error = new Error(`Prisma ${code}`) as PrismaError;
        error.code = code;

        errorHandler(error, req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: expect.objectContaining({
              code: 'INTERNAL_ERROR',
            }),
          }),
        );
        expect(res.setHeader).not.toHaveBeenCalledWith('Retry-After', expect.anything());
      },
    );

    it('does not shadow the existing P2002 DuplicateEmail routing', () => {
      const error = new Error('Unique constraint failed') as PrismaError;
      error.code = 'P2002';
      error.meta = { target: ['email'] };

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'DUPLICATE_EMAIL',
          }),
        }),
      );
    });

    it('falls through to InternalServerError for unknown Prisma codes', () => {
      const error = new Error('Unknown Prisma error') as PrismaError;
      error.code = 'P9999';

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'INTERNAL_ERROR',
          }),
        }),
      );
    });
  });

  describe('Invalid UUID Format Handling', () => {
    it('should handle invalid UUID format error', () => {
      const error = new Error('Invalid UUID') as PrismaError;
      error.code = 'INVALID_UUID';

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'INVALID_ID_FORMAT',
            message: 'Invalid ID format',
          }),
          requestId: 'test-request-id',
        }),
      );
    });
  });

  describe('JSON parsing error handling', () => {
    it('should handle JSON SyntaxError', () => {
      const error: any = new SyntaxError('Unexpected token');
      error.status = 400;
      error.body = 'invalid json';

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'INVALID_JSON',
            message: 'Invalid JSON in request body',
          }),
          requestId: 'test-request-id',
        }),
      );
    });

    it('should not handle SyntaxError without body property', () => {
      const error: any = new SyntaxError('Other syntax error');
      error.status = 400;
      // No 'body' property

      errorHandler(error, req, res, next);

      // Should fall through to generic error handler
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should treat SyntaxError with non-400 status as internal error', () => {
      const error: any = new SyntaxError('Other error');
      error.status = 500;
      error.body = 'something';

      errorHandler(error, req, res, next);

      // Should fall through to generic error handler
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('Unknown error handling', () => {
    it('should handle unknown errors with InternalServerError', () => {
      const error = new Error('Something went wrong');

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
          }),
          requestId: 'test-request-id',
        }),
      );
    });

    it('should log error with context', () => {
      req.userId = 'user-123';
      req.body = { text: 'test' };
      req.params = { id: 'abc' };
      req.query = { filter: 'active' };

      const error = new Error('Test error');

      errorHandler(error, req, res, next);

      expect(req.log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: error,
          userId: 'user-123',
          body: { text: 'test' },
          params: { id: 'abc' },
          query: { filter: 'active' },
        }),
        'Test error',
      );
    });

    it("should use 'Unhandled error' message when error has no message", () => {
      const error = new Error();
      error.message = '';

      errorHandler(error, req, res, next);

      expect(req.log.error).toHaveBeenCalledWith(expect.anything(), 'Unhandled error');
    });
  });
});
