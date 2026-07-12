import express, { Response, Router } from 'express';
import UserService from '../models/User.js';
import TodoService from '../models/Todo.js';
import { auth, requireUserId } from '../middleware/auth.js';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter.js';
import { validate, schemas } from '../middleware/validation.js';
import { InvalidCredentialsError, UserNotFoundError } from '../errors/index.js';
import { writeOrLog } from '../lib/auditLog.js';
import { AuditAction } from '../lib/auditActions.js';
import prisma from '../lib/prisma.js';
import type { RequestWithLogger } from '../types/index.js';

// Self-service account management. Handlers throw typed AppErrors and rely on
// Express 5 async error forwarding + the global errorHandler (same style as
// routes/auth.ts) — the handler maps DuplicateEmail/InvalidCredentials/etc. and
// stamps requestId, so we don't repeat that plumbing per route.
const router: Router = express.Router();

// GET current user's profile.
router.get('/me', auth, readLimiter, async (req, res: Response): Promise<void> => {
  const { log } = req as RequestWithLogger;
  const userId = requireUserId(req);

  const profile = await UserService.findById(userId);
  if (!profile) {
    // Token verified but the row is gone (e.g. deleted on another device).
    throw new UserNotFoundError();
  }

  log.info({ userId }, 'User profile fetched');
  res.json(profile);
});

// PATCH profile: name and/or email. An email change re-authenticates with the
// current password (validation guarantees currentPassword is present iff email is).
router.patch(
  '/me',
  auth,
  writeLimiter,
  validate(schemas.updateProfile),
  async (req, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const userId = requireUserId(req);
    const { name, email, currentPassword } = req.body as {
      name?: string;
      email?: string;
      currentPassword?: string;
    };

    if (email !== undefined) {
      const ok = currentPassword ? await UserService.verifyPassword(userId, currentPassword) : false;
      if (!ok) throw new InvalidCredentialsError();
    }

    const patch: { name?: string; email?: string } = {};
    if (name !== undefined) patch.name = name;
    if (email !== undefined) patch.email = email;

    const updated = await UserService.updateProfile(userId, patch);
    log.info({ userId, fields: Object.keys(patch), emailChanged: email !== undefined }, 'User profile updated');
    res.json(updated);
  },
);

// PATCH password: verify current password, then rotate it and revoke all
// refresh tokens (forces re-login on every device).
router.patch(
  '/me/password',
  auth,
  writeLimiter,
  validate(schemas.changePassword),
  async (req, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const userId = requireUserId(req);
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string;
      newPassword: string;
    };

    const ok = await UserService.verifyPassword(userId, currentPassword);
    if (!ok) throw new InvalidCredentialsError();

    const { revokedCount } = await UserService.changePassword(userId, newPassword);
    log.info({ userId, revokedCount }, 'User password changed; sessions revoked');
    res.json({ message: 'Password changed. Please log in again.' });
  },
);

// DELETE account: re-authenticate, then audit + delete (todos and refresh
// tokens cascade away). Returns 204.
router.delete(
  '/me',
  auth,
  writeLimiter,
  validate(schemas.deleteAccount),
  async (req, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const userId = requireUserId(req);
    const { currentPassword } = req.body as { currentPassword: string };

    const ok = await UserService.verifyPassword(userId, currentPassword);
    if (!ok) throw new InvalidCredentialsError();

    await UserService.deleteAccount(userId);
    log.info({ userId }, 'User account deleted');
    res.status(204).end();
  },
);

// GET data export (SOC 2 Privacy — data portability). Returns the full profile
// plus every todo as a downloadable JSON attachment, and audits the access.
router.get('/me/export', auth, readLimiter, async (req, res: Response): Promise<void> => {
  const { log } = req as RequestWithLogger;
  const userId = requireUserId(req);

  const profile = await UserService.findById(userId);
  if (!profile) throw new UserNotFoundError();
  const todos = await TodoService.findAllByUser(userId);

  void writeOrLog(
    prisma,
    {
      action: AuditAction.UserExport,
      outcome: 'success',
      entityType: 'User',
      entityId: userId,
      changedBy: userId,
      metadata: { todoCount: todos.length },
    },
    log,
  );

  log.info({ userId, todoCount: todos.length }, 'User data exported');
  res.setHeader('Content-Disposition', `attachment; filename="todo-api-export-${userId}.json"`);
  res.json({ user: profile, todos });
});

export default router;
