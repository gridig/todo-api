import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';

// ==================== Database Models ====================

// Authorization role. Fixed domain, enforced at the DB layer by a CHECK
// constraint (users_role_check) and at the app layer by this union.
export type UserRole = 'user' | 'admin';

export interface User {
  id: string;
  // At the service boundary `email` is always plaintext (create/findByEmail
  // decrypt before returning); at rest the column holds AES-256-GCM ciphertext.
  email: string;
  // Keyed HMAC blind index over the canonical email — the lookup/uniqueness key.
  emailHash: string;
  // Optional user-chosen display name (plaintext at rest).
  name: string | null;
  role: UserRole;
  password: string;
  createdAt: Date;
  updatedAt: Date;
}

// findByEmail returns only these three; email is decrypted, emailHash omitted.
export type UserLoginFields = Pick<User, 'id' | 'email' | 'password'>;

// Public profile shape returned by the /user/me and /admin/users endpoints —
// never carries the password hash or emailHash. email is decrypted before it
// reaches this type.
export type UserProfile = Pick<User, 'id' | 'email' | 'name' | 'role' | 'createdAt' | 'updatedAt'>;

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
  // Read a user's public profile by id (email decrypted); null if not found.
  findById(userId: string): Promise<UserProfile | null>;
  comparePassword(plainPassword: string, hashedPassword: string): Promise<boolean>;
  // Re-auth helper: compare a plaintext password against the stored hash for a
  // given user id. false when the user does not exist.
  verifyPassword(userId: string, plainPassword: string): Promise<boolean>;
  updatePassword(userId: string, plainPassword: string): Promise<void>;
  // Update profile fields (name and/or email). An email change re-encrypts the
  // ciphertext column and recomputes the blind index atomically, audits the
  // change, and throws DuplicateEmailError on a blind-index collision.
  updateProfile(userId: string, patch: { name?: string; email?: string }): Promise<UserProfile>;
  // Change password and revoke every live refresh token for the user in one
  // transaction. Returns how many tokens were revoked.
  changePassword(userId: string, newPassword: string): Promise<{ revokedCount: number }>;
  // Audit then delete the user; Todo/RefreshToken rows cascade away.
  deleteAccount(userId: string): Promise<void>;
  // --- RBAC ---
  // Current role for a user id, or null if the user does not exist. Lean lookup
  // used by the requireRole authorization middleware on admin routes.
  getRole(userId: string): Promise<UserRole | null>;
  // Paginated user listing for the admin surface (email decrypted per row).
  listUsers(params?: PaginationParams): Promise<PaginatedResult<UserProfile>>;
  // Change a user's role; audits admin.user.role.change (changedBy = adminId)
  // inside the transaction. Throws UserNotFoundError if the target is missing.
  setRole(targetId: string, role: UserRole, adminId: string): Promise<UserProfile>;
  // Admin-initiated deletion of another user; audits admin.user.delete
  // (changedBy = adminId) then deletes (Todo/RefreshToken cascade).
  adminDeleteUser(targetId: string, adminId: string): Promise<void>;
  needsRehash(hashedPassword: string): boolean;
  deleteMany(): Promise<{ count: number }>;
}

export interface TodoServiceInterface {
  create(data: { text: string; userId: string; done?: boolean }): Promise<Todo>;
  findByUser(userId: string, params?: PaginationParams): Promise<PaginatedResult<Todo>>;
  findOne(params: { id: string; userId: string }): Promise<Todo | null>;
  // Every todo for a user, unpaginated — used by the data-export endpoint.
  findAllByUser(userId: string): Promise<Todo[]>;
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
