import { Application } from 'express';
import type { User, JWTPayload } from '../../types/index.js';
import { createApp } from '../../app.js';
import prisma, { pool, probePool } from '../../lib/prisma.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import UserService from '../../models/User.js';
import TodoService from '../../models/Todo.js';
import { env } from '../../config/env.js';

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
export async function createTestUser(
  email: string | null = null
): Promise<TestUserResult> {
  // Use timestamp to ensure unique email if not provided
  const userEmail = email || `test-${generateUniqueId()}@example.com`;

  const user = await UserService.create({
    email: userEmail,
    password: 'TestPass123!',
  });

  // Issue test tokens in the same shape production issues: sub + iss + aud.
  // Keeps the test suite forward-compatible with JWT_VERIFY_REQUIRE_CLAIMS=true.
  const authToken = jwt.sign(
    { sub: user.id } as JWTPayload,
    env.JWT_SECRET,
    {
      expiresIn: '24h',
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }
  );

  return { user, authToken, userId: user.id };
}

export async function connectTestDB(): Promise<void> {
  await prisma.$connect();
}

export async function disconnectTestDB(): Promise<void> {
  await prisma.$disconnect();
  await Promise.all([pool.end(), probePool.end()]);
}

export async function cleanupTestData(): Promise<void> {
  // Delete in correct order due to foreign key constraints
  await TodoService.deleteMany();
  await UserService.deleteMany();
}
