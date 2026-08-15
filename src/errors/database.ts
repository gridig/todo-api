import { AppError, ConflictError, InternalServerError, ServiceUnavailableError } from './index.js';

// 503 with code DATABASE_UNAVAILABLE — clients should retry on this code and
// honour the Retry-After header. Inherits ServiceUnavailableError so the
// existing Retry-After plumbing in middleware/errorHandler.ts works for free.
export class DatabaseUnavailableError extends ServiceUnavailableError {
  constructor(
    message: string = 'Database temporarily unavailable',
    retryAfterSeconds: number = 30,
  ) {
    super(message, 'DATABASE_UNAVAILABLE', retryAfterSeconds);
  }
}

interface PrismaLikeError {
  code: string;
}

const hasPrismaCode = (err: unknown): err is PrismaLikeError =>
  typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  typeof (err as { code: unknown }).code === 'string';

// P2002 = unique-constraint violation. Lives here rather than in one model so
// every caller that races a unique index (users.email_hash from registration,
// profile update, and email-change redemption) tests it the same way.
export const isUniqueViolation = (err: unknown): boolean =>
  hasPrismaCode(err) && err.code === 'P2002';

// Map Prisma error codes to typed AppErrors.
// Returns null for codes the existing errorHandler already handles with richer
// context (P2002 → DuplicateEmail/DuplicateValue field detection, P2025 →
// NotFound) or for codes we don't recognise (let the InternalServerError
// fallback handle them).
export function classifyPrismaError(err: unknown): AppError | null {
  if (!hasPrismaCode(err)) return null;

  switch (err.code) {
    // Transient — DB unreachable / timeout. Client should retry.
    case 'P1001': // Can't reach database server
    case 'P1002': // Database server timeout
    case 'P1008': // Operation timed out
    case 'P1017': // Server has closed the connection
      return new DatabaseUnavailableError();

    // Pool timeout — drains in seconds, short Retry-After matches the
    // pool-saturation logic in routes/health.ts.
    case 'P2024':
      return new DatabaseUnavailableError('Database connection pool exhausted', 5);

    // Write conflict / deadlock inside an interactive transaction. Transient by
    // definition — every $transaction in the codebase can hit it under
    // contention, and a 500 would tell the client not to retry something that
    // succeeds on the next attempt.
    case 'P2034':
      return new DatabaseUnavailableError('Transaction conflict, please retry', 5);

    // FK constraint — conflict (409).
    case 'P2003':
      return new ConflictError('Foreign key constraint failed', 'FOREIGN_KEY_CONSTRAINT');

    // Auth / access misconfiguration — not retryable; surfaces as 500 because
    // the client can do nothing about it.
    case 'P1000': // Authentication failed
    case 'P1010': // User denied access
      return new InternalServerError();

    default:
      return null;
  }
}
