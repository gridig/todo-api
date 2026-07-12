import { Application } from 'express';
import { Pool, type QueryResultRow } from 'pg';
import type { User, JWTPayload } from '@/types/index.js';
import { createApp } from '@/app.js';
import prisma, { pool, probePool } from '@/lib/prisma.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import UserService from '@/models/User.js';
import TodoService from '@/models/Todo.js';
import RefreshTokenService from '@/models/RefreshToken.js';
import { env } from '@/config/env.js';

// Privileged pool wired to the admin DSN so tests can TRUNCATE audit_entries
// (the runtime db_app role is denied UPDATE/DELETE/TRUNCATE by design). Lazy
// so suites that never touch the audit table do not pay the connect cost.
let adminPoolInstance: Pool | undefined;
const getAdminPool = (): Pool => {
  if (!adminPoolInstance) {
    adminPoolInstance = new Pool({
      connectionString: process.env.DATABASE_MIGRATE_URL ?? env.DATABASE_URL,
      max: 1,
    });
  }
  return adminPoolInstance;
};

export async function truncateAuditEntries(): Promise<void> {
  await getAdminPool().query('TRUNCATE audit_entries RESTART IDENTITY CASCADE');
}

// Poll for an audit row matching the predicate. Necessary because audit writes
// from auth/route handlers are fire-and-forget (`void writeOrLog(...)`), so the
// row may not be visible the instant the HTTP response returns to the test.
export async function pollForAuditRow<T extends QueryResultRow>(
  whereClause: string,
  params: unknown[] = [],
  options: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<T | null> {
  const maxAttempts = options.maxAttempts ?? 40;
  const intervalMs = options.intervalMs ?? 25;
  const sql = `SELECT * FROM audit_entries WHERE ${whereClause} ORDER BY changed_at DESC LIMIT 1`;
  for (let i = 0; i < maxAttempts; i++) {
    const res = await getAdminPool().query<T>(sql, params);
    if (res.rowCount && res.rowCount > 0) return res.rows[0] ?? null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// Generate a unique ID for test isolation using cryptographic UUID
export function generateUniqueId(): string {
  return crypto.randomUUID();
}

// Create test app - reusable across all test files
export function createTestApp(): Application {
  return createApp();
}

interface TestUserResult {
  user: User;
  authToken: string;
  userId: string;
}

// Setup test user and auth token - reusable
export async function createTestUser(email: string | null = null): Promise<TestUserResult> {
  // Use timestamp to ensure unique email if not provided
  const userEmail = email || `test-${generateUniqueId()}@example.com`;

  const user = await UserService.create({
    email: userEmail,
    password: 'TestPass123!',
  });

  // Issue test tokens in the same shape production issues: sub + iss + aud
  // (iss/aud are enforced unconditionally by middleware/auth.ts).
  const authToken = jwt.sign({ sub: user.id } as JWTPayload, env.JWT_SECRET, {
    expiresIn: '24h',
    algorithm: 'HS256',
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });

  return { user, authToken, userId: user.id };
}

// Like createTestUser, but promotes the user to admin after creation. The JWT is
// still sub-only (role is never in the token) — authorization is enforced by a
// per-request DB role lookup, so setting the column is what makes an admin.
export async function createTestAdmin(email: string | null = null): Promise<TestUserResult> {
  const result = await createTestUser(email);
  await prisma.user.update({ where: { id: result.userId }, data: { role: 'admin' } });
  return result;
}

export async function connectTestDB(): Promise<void> {
  await prisma.$connect();
}

export async function disconnectTestDB(): Promise<void> {
  await prisma.$disconnect();
  const closes: Promise<unknown>[] = [pool.end(), probePool.end()];
  if (adminPoolInstance) closes.push(adminPoolInstance.end());
  await Promise.all(closes);
}

export async function cleanupTestData(): Promise<void> {
  // Delete in correct order due to foreign key constraints. Refresh tokens and
  // todos both FK-reference users, so they must go before UserService. (User
  // deletion cascades to both at the DB layer, but clearing them explicitly
  // keeps the intent obvious and lets suites reset tokens without users.)
  await RefreshTokenService.deleteMany();
  await TodoService.deleteMany();
  await UserService.deleteMany();
}
