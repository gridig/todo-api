import type { ErrorResponse } from '../types/index.js';

export class AppError extends Error {
  statusCode: number;
  code: string;
  details: Record<string, unknown> | null;
  isOperational: boolean;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
      },
    };
  }
}

// Authentication errors
export class AuthError extends AppError {
  constructor(
    message: string = 'Authentication failed',
    code: string = 'AUTH_ERROR',
    details: Record<string, unknown> | null = null,
  ) {
    super(message, 401, code, details);
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super('Invalid email or password', 'INVALID_CREDENTIALS', {
      suggestion: 'Please check your email and password and try again',
    });
  }
}

export class NoTokenError extends AuthError {
  constructor() {
    super('No authentication token provided', 'NO_TOKEN', {
      suggestion: 'Include a valid JWT token in the Authorization header',
    });
  }
}

export class InvalidTokenError extends AuthError {
  constructor() {
    super('Invalid or expired token', 'INVALID_TOKEN', {
      suggestion: 'Please log in again to get a new token',
    });
  }
}

// Validation errors
export class ValidationError extends AppError {
  constructor(
    message: string = 'Validation failed',
    details: Record<string, unknown> | null = null,
  ) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class InvalidIdFormatError extends ValidationError {
  constructor() {
    super('Invalid ID format', {
      suggestion: 'Provide a valid UUID',
    });
    this.code = 'INVALID_ID_FORMAT';
  }
}

// Authorization errors
export class ForbiddenError extends AppError {
  constructor(
    message: string = 'Access denied',
    code: string = 'FORBIDDEN',
    details: Record<string, unknown> | null = null,
  ) {
    super(message, 403, code, details);
  }
}

// Login refused because the address was never confirmed. Deliberately 403, not
// 401: the credentials were correct, so retrying them changes nothing — the
// client must send the user through POST /auth/resend-verification. This does
// not reintroduce the enumeration oracle that M3 closed, because the branch is
// only reachable after a successful password check.
export class EmailNotVerifiedError extends ForbiddenError {
  constructor() {
    super('Email address not verified', 'EMAIL_NOT_VERIFIED', {
      suggestion: 'Check your inbox for the verification link, or request a new one',
    });
  }
}

// Verification-token redemption failures. The three cases are distinguished
// because the client can act differently on each (retry the link, request a new
// one, or stop), and the distinction leaks nothing: reaching any of them
// requires already holding a 256-bit token value.
export type VerificationFailureReason = 'invalid' | 'expired' | 'already_used';

const VERIFICATION_FAILURES: Record<
  VerificationFailureReason,
  { code: string; message: string; suggestion: string }
> = {
  invalid: {
    code: 'VERIFICATION_TOKEN_INVALID',
    message: 'Verification link is not valid',
    suggestion: 'Request a new verification email',
  },
  expired: {
    code: 'VERIFICATION_TOKEN_EXPIRED',
    message: 'Verification link has expired',
    suggestion: 'Request a new verification email',
  },
  already_used: {
    code: 'VERIFICATION_TOKEN_USED',
    message: 'Verification link has already been used',
    suggestion: 'Your address may already be verified — try logging in',
  },
};

export class InvalidVerificationTokenError extends AppError {
  constructor(reason: VerificationFailureReason) {
    const { code, message, suggestion } = VERIFICATION_FAILURES[reason];
    super(message, 400, code, { suggestion });
  }
}

// Conflict errors — resource already exists or version mismatch (HTTP 409)
export class ConflictError extends AppError {
  constructor(
    message: string = 'Conflict',
    code: string = 'CONFLICT',
    details: Record<string, unknown> | null = null,
  ) {
    super(message, 409, code, details);
  }
}

export class DuplicateEmailError extends ConflictError {
  constructor() {
    super('Email already exists', 'DUPLICATE_EMAIL', {
      suggestion: 'Please use a different email address or try logging in',
    });
  }
}

export class DuplicateValueError extends ConflictError {
  constructor(field: string) {
    super(`${field.charAt(0).toUpperCase() + field.slice(1)} already exists`, 'DUPLICATE_VALUE', {
      field,
      suggestion: `Please use a different ${field}`,
    });
  }
}

// Service unavailable errors — transient failures the client can safely retry (HTTP 503)
export class ServiceUnavailableError extends AppError {
  retryable: boolean;
  retryAfterSeconds: number;

  constructor(
    message: string = 'Service temporarily unavailable',
    code: string = 'SERVICE_UNAVAILABLE',
    retryAfterSeconds: number = 30,
  ) {
    super(message, 503, code, {
      suggestion: 'Please try again later',
      retryable: true,
      retryAfter: retryAfterSeconds,
    });
    this.retryable = true;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Not found errors
export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource', code: string = 'NOT_FOUND') {
    super(`${resource} not found`, 404, code, {
      suggestion: `Verify the ${resource.toLowerCase()} ID exists and belongs to you`,
    });
  }
}

export class TodoNotFoundError extends NotFoundError {
  constructor() {
    super('Todo', 'TODO_NOT_FOUND');
  }
}

export class UserNotFoundError extends NotFoundError {
  constructor() {
    super('User', 'USER_NOT_FOUND');
  }
}

export class RouteNotFoundError extends NotFoundError {
  constructor(path: string) {
    super('Route', 'ROUTE_NOT_FOUND');
    this.details = {
      path,
      suggestion: 'Check the API documentation for available endpoints',
    };
  }
}

// Server errors
export class InternalServerError extends AppError {
  constructor(message: string = 'An unexpected error occurred') {
    super(message, 500, 'INTERNAL_ERROR', {
      suggestion: 'Please try again later or contact support if the issue persists',
    });
  }
}

// Rate limit error
export class RateLimitError extends AppError {
  constructor(retryAfter: number | null = null) {
    super('Too many requests', 429, 'RATE_LIMIT_EXCEEDED', {
      suggestion: 'Please slow down and try again later',
      ...(retryAfter && { retryAfter }),
    });
  }
}
