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
import type { ErrorResponse, RequestWithLogger } from '../types/index.js';

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

// What the client gets back, resolved before anything is written so the log
// line can be levelled by the status actually returned.
interface ResolvedError {
  statusCode: number;
  body: ErrorResponse;
  retryAfterSeconds?: number;
}

const fromAppError = (appError: AppError): ResolvedError => ({
  statusCode: appError.statusCode,
  body: appError.toJSON(),
  ...(appError instanceof ServiceUnavailableError && {
    retryAfterSeconds: appError.retryAfterSeconds,
  }),
});

// Same levelling rule as requestLogger: 4xx and 503 (deliberate backpressure)
// are WARN, every other 5xx is ERROR — so ERROR keeps its signal value for
// on-call alerting instead of firing on every bad password or 404. Client
// errors are expected outcomes, so they log the typed code rather than a stack.
//
// The request body is logged by key only. Values include free text (todo
// `text`, display `name`) that REDACT_PATHS does not — and cannot sensibly —
// cover, so logging them would put user PII in the log stream on every error.
const logHandledError = (req: RequestWithLogger, err: Error, statusCode: number): void => {
  const context = {
    userId: (req as RequestWithLogger & { userId?: string }).userId,
    statusCode,
    bodyKeys:
      req.body && typeof req.body === 'object' ? Object.keys(req.body as object) : undefined,
    params: req.params,
    query: req.query,
  };
  const msg = err.message || 'Unhandled error';

  if (statusCode < 500) {
    const code = err instanceof AppError ? err.code : undefined;
    req.log.warn({ ...context, errCode: code, errName: err.name }, msg);
  } else if (statusCode === 503) {
    // Using 'err' key triggers Pino's automatic error serialization.
    req.log.warn({ ...context, err }, msg);
  } else {
    req.log.error({ ...context, err }, msg);
  }
};

export const errorHandler = (
  err: Error,
  req: RequestWithLogger,
  res: Response,
  next: NextFunction,
): void => {
  // A response already on the wire can't carry a JSON error body; delegate to
  // Express's default handler, which closes the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  const response = toErrorResponse(err);
  logHandledError(req, err, response.statusCode);

  if (response.retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(response.retryAfterSeconds));
  }
  res.status(response.statusCode).json({ ...response.body, requestId: req.id });
};

const toErrorResponse = (err: Error): ResolvedError => {
  // Handle our custom AppError instances
  if (err instanceof AppError) {
    return fromAppError(err);
  }

  // Map known Prisma error codes (transient → 503, FK conflict → 409, etc.)
  // to typed AppErrors. Returns null for P2002/P2025 (handled below with
  // richer field-level routing) and for codes we don't recognise.
  const classified = classifyPrismaError(err);
  if (classified) {
    return fromAppError(classified);
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
    return fromAppError(
      isEmailConstraint ? new DuplicateEmailError() : new DuplicateValueError(field),
    );
  }

  // Handle Prisma P2025 record not found
  if (hasCode(err) && err.code === 'P2025') {
    return fromAppError(new NotFoundError('Record'));
  }

  // Handle invalid UUID format
  if (hasCode(err) && err.code === 'INVALID_UUID') {
    return {
      statusCode: 400,
      body: {
        error: {
          code: 'INVALID_ID_FORMAT',
          message: 'Invalid ID format',
          details: {
            suggestion: 'Provide a valid UUID',
          },
        },
      },
    };
  }

  // Handle JSON parsing errors
  if (isJsonParseError(err)) {
    return {
      statusCode: 400,
      body: {
        error: {
          code: 'INVALID_JSON',
          message: 'Invalid JSON in request body',
          details: {
            suggestion: 'Ensure your request body contains valid JSON',
          },
        },
      },
    };
  }

  // Handle body-parser PayloadTooLargeError (BODY_LIMIT exceeded) → 413
  if (isPayloadTooLargeError(err)) {
    return {
      statusCode: 413,
      body: {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body exceeds the configured size limit',
          details: {
            suggestion: 'Reduce the request body size and retry',
          },
        },
      },
    };
  }

  // Fallback for unknown errors (don't expose internal details)
  return fromAppError(new InternalServerError());
};
