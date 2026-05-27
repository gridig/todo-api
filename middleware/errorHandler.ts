import { Response, NextFunction } from 'express';
import {
  AppError,
  DuplicateEmailError,
  DuplicateValueError,
  InternalServerError,
  NotFoundError,
  ServiceUnavailableError,
} from '../errors/index.js';
import { classifyPrismaError } from '../errors/database.js';
import type { RequestWithLogger } from '../types/index.js';

// Type guard for errors with a code property (Prisma errors, etc.)
// Prisma 7 + driver adapter puts constraint info under driverAdapterError.cause.constraint.fields
// rather than the legacy meta.target field — handle both shapes.
interface CodedError extends Error {
  code: string;
  meta?: {
    target?: string[] | string;
    driverAdapterError?: {
      cause?: {
        constraint?: { fields?: string[] };
      };
    };
  };
}

// JSON parse error (Express adds 'status' to SyntaxError)
interface JsonParseError extends SyntaxError {
  status: number;
}

// body-parser PayloadTooLargeError surfaces here when express.json's `limit`
// is exceeded. The error carries `type: 'entity.too.large'` and `status: 413`.
interface PayloadTooLargeError extends Error {
  type: string;
  status: number;
  statusCode: number;
}

const hasCode = (error: unknown): error is CodedError => {
  return typeof error === 'object' && error !== null && 'code' in error;
};

const isJsonParseError = (error: unknown): error is JsonParseError => {
  return (
    error instanceof SyntaxError &&
    'status' in error &&
    (error as JsonParseError).status === 400 &&
    'body' in error
  );
};

const isPayloadTooLargeError = (error: unknown): error is PayloadTooLargeError => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as PayloadTooLargeError).type === 'entity.too.large'
  );
};

const respondWithAppError = (res: Response, requestId: string, appError: AppError): void => {
  if (appError instanceof ServiceUnavailableError) {
    res.setHeader('Retry-After', String(appError.retryAfterSeconds));
  }
  res.status(appError.statusCode).json({
    ...appError.toJSON(),
    requestId,
  });
};

export const errorHandler = (
  err: Error,
  req: RequestWithLogger,
  res: Response,
  _next: NextFunction,
): void => {
  const { log, id: requestId } = req;
  // Log error with full context
  // Using 'err' key triggers Pino's automatic error serialization

  log.error(
    {
      err,
      userId: (req as RequestWithLogger & { userId?: string }).userId,
      body: req.body,
      params: req.params,
      query: req.query,
    },
    err.message || 'Unhandled error',
  );

  // Handle our custom AppError instances
  if (err instanceof AppError) {
    respondWithAppError(res, requestId, err);
    return;
  }

  // Map known Prisma error codes (transient → 503, FK conflict → 409, etc.)
  // to typed AppErrors. Returns null for P2002/P2025 (handled below with
  // richer field-level routing) and for codes we don't recognise.
  const classified = classifyPrismaError(err);
  if (classified) {
    respondWithAppError(res, requestId, classified);
    return;
  }

  // Handle Prisma P2002 unique constraint violation.
  // Field resolution: Prisma 7 + driver adapter uses driverAdapterError.cause.constraint.fields;
  // older Prisma uses meta.target. Try both so the check works across versions.
  if (hasCode(err) && err.code === 'P2002') {
    const legacyTarget = err.meta?.target;
    const adapterFields = err.meta?.driverAdapterError?.cause?.constraint?.fields;
    const fields: string[] = Array.isArray(legacyTarget)
      ? legacyTarget
      : typeof legacyTarget === 'string'
        ? [legacyTarget]
        : Array.isArray(adapterFields)
          ? adapterFields
          : [];
    const field = fields[0] ?? 'field';
    const isEmailConstraint = fields.some((f) => f.toLowerCase().includes('email'));
    const constraintError = isEmailConstraint
      ? new DuplicateEmailError()
      : new DuplicateValueError(field);
    res.status(constraintError.statusCode).json({
      ...constraintError.toJSON(),
      requestId,
    });
    return;
  }

  // Handle Prisma P2025 record not found
  if (hasCode(err) && err.code === 'P2025') {
    const notFoundError = new NotFoundError('Record');
    res.status(notFoundError.statusCode).json({
      ...notFoundError.toJSON(),
      requestId,
    });
    return;
  }

  // Handle invalid UUID format
  if (hasCode(err) && err.code === 'INVALID_UUID') {
    res.status(400).json({
      error: {
        code: 'INVALID_ID_FORMAT',
        message: 'Invalid ID format',
        details: {
          suggestion: 'Provide a valid UUID',
        },
      },
      requestId,
    });
    return;
  }

  // Handle JSON parsing errors
  if (isJsonParseError(err)) {
    res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Invalid JSON in request body',
        details: {
          suggestion: 'Ensure your request body contains valid JSON',
        },
      },
      requestId,
    });
    return;
  }

  // Handle body-parser PayloadTooLargeError (BODY_LIMIT exceeded) → 413
  if (isPayloadTooLargeError(err)) {
    res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the configured size limit',
        details: {
          suggestion: 'Reduce the request body size and retry',
        },
      },
      requestId,
    });
    return;
  }

  // Fallback for unknown errors (don't expose internal details)
  const serverError = new InternalServerError();
  res.status(serverError.statusCode).json({
    ...serverError.toJSON(),
    requestId,
  });
};
