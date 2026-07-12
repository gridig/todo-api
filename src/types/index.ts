import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';

// ==================== Database Models ====================

export interface User {
  id: string;
  // At the service boundary `email` is always plaintext (create/findByEmail
  // decrypt before returning); at rest the column holds AES-256-GCM ciphertext.
  email: string;
  // Keyed HMAC blind index over the canonical email — the lookup/uniqueness key.
  emailHash: string;
  password: string;
  createdAt: Date;
  updatedAt: Date;
}

// findByEmail returns only these three; email is decrypted, emailHash omitted.
export type UserLoginFields = Pick<User, 'id' | 'email' | 'password'>;

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshTokenRecord {
  id: string;
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  replacedByHash: string | null;
}

// Discriminated result of verifying a presented refresh token. `revoked`
// carries the row so the caller can trigger reuse/theft handling (revoke the
// user's whole token set); `expired`/`not_found` are indistinguishable to the
// client (both → 401) but separated here for audit granularity.
export type RefreshTokenVerifyResult =
  | { status: 'valid'; token: RefreshTokenRecord }
  | { status: 'revoked'; token: RefreshTokenRecord }
  | { status: 'expired' }
  | { status: 'not_found' };

// ==================== Request Extensions ====================

// Simple version for routes without params
export type AuthenticatedRequest = Request & {
  userId: string;
  id: string;
  log: Logger;
};

export interface RequestWithLogger extends Request {
  id: string;
  log: Logger;
}

// ==================== Pagination Types ====================

export interface PaginationParams {
  limit?: number;
  cursor?: string;
}

export interface PaginatedMeta {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PaginatedMeta;
}

// ==================== API Request/Response Types ====================

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface CreateTodoRequest {
  text: string;
}

export interface AuthResponse {
  token: string;
  refreshToken: string;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId?: string;
}

export type AuthRouteResponse = AuthResponse | ErrorResponse;

// ==================== JWT Types ====================

// Tokens carry the RFC 7519 `sub` claim (user id) plus `iss`/`aud`, set on the
// sign side in routes/auth.ts and enforced unconditionally by middleware/auth.ts.
export interface JWTPayload {
  sub: string;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
}

// ==================== Middleware Types ====================

export type AsyncRequestHandler = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => Promise<void> | void;

export type RequestHandler = (req: Request, res: Response, next: NextFunction) => void;

export type ErrorRequestHandler = (
  err: Error,
  req: RequestWithLogger,
  res: Response,
  next: NextFunction,
) => void;

// ==================== Service Types ====================

export interface UserServiceInterface {
  create(data: { email: string; password: string }): Promise<User>;
  findByEmail(email: string): Promise<UserLoginFields | null>;
  comparePassword(plainPassword: string, hashedPassword: string): Promise<boolean>;
  updatePassword(userId: string, plainPassword: string): Promise<void>;
  needsRehash(hashedPassword: string): boolean;
  deleteMany(): Promise<{ count: number }>;
}

export interface TodoServiceInterface {
  create(data: { text: string; userId: string; done?: boolean }): Promise<Todo>;
  findByUser(userId: string, params?: PaginationParams): Promise<PaginatedResult<Todo>>;
  findOne(params: { id: string; userId: string }): Promise<Todo | null>;
  toggleDone(params: { id: string; userId: string }): Promise<Todo | null>;
  delete(params: { id: string; userId: string }): Promise<Todo | null>;
  deleteMany(filter?: { userId?: string }): Promise<{ count: number }>;
  deleteManyByUser(userId: string): Promise<{ count: number }>;
}

export interface RefreshTokenServiceInterface {
  // Issue a new refresh token, returning the raw (unhashed) value to hand the
  // client. Accepts an optional transaction client so issuance can be bundled
  // atomically with, e.g., user registration.
  issue(userId: string): Promise<string>;
  verify(rawToken: string): Promise<RefreshTokenVerifyResult>;
  // Rotate a verified token: atomically revoke it and issue its successor.
  // Returns the new raw token, or null if the token was already rotated
  // concurrently (lost race → caller treats as reuse).
  rotate(oldToken: RefreshTokenRecord): Promise<string | null>;
  // Revoke the presented token (logout). Returns true if a live token was revoked.
  revoke(rawToken: string): Promise<boolean>;
  revokeAllForUser(userId: string): Promise<{ count: number }>;
  deleteExpired(): Promise<{ count: number }>;
  deleteMany(): Promise<{ count: number }>;
}

// ==================== Error Types ====================

export interface PrismaError extends Error {
  code?: string;
  meta?: Record<string, unknown>;
}
