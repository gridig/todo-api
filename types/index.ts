import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';

// ==================== Database Models ====================

export interface User {
  id: string;
  email: string;
  password: string;
  createdAt: Date;
  updatedAt: Date;
}

export type UserLoginFields = Pick<User, 'id' | 'email' | 'password'>;

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

// ==================== Request Extensions ====================

export interface AuthenticatedRequestBody<TParams = object, TBody = unknown> extends Request<
  TParams,
  unknown,
  TBody
> {
  userId: string;
  id: string;
  log: Logger;
}

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

// Tokens issued post-2026-05 use `sub` (RFC 7519 standard claim) plus
// `iss`/`aud`. Tokens issued before the rollout still carry the legacy
// `userId` payload; middleware/auth.ts accepts either while the grace
// window flag JWT_VERIFY_REQUIRE_CLAIMS is false, then drops the
// back-compat path on the follow-up deploy.
export interface JWTPayload {
  sub?: string;
  userId?: string;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
}

// ==================== Environment Types ====================

export interface EnvConfig {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  CORS_ORIGIN: string;
  CORS_CREDENTIALS: string;
  CORS_METHODS: string;
  CORS_HEADERS: string;
  CORS_MAX_AGE: string;
  LOG_LEVEL?: string;
  LOG_FILE_PATH: string;
  LOG_MAX_FILE_SIZE: string;
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

// ==================== Error Types ====================

export interface PrismaError extends Error {
  code?: string;
  meta?: Record<string, unknown>;
}
