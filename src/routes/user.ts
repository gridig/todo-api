import express, { Response, Router } from 'express';
import UserService from '../models/User.js';
import TodoService from '../models/Todo.js';
import EmailChangeTokenService from '../models/EmailChangeToken.js';
import { auth, requireUserId } from '../middleware/auth.js';
import {
  emailChangeLimiter,
  exportLimiter,
  readLimiter,
  writeLimiter,
} from '../middleware/rateLimiter.js';
import { validate, schemas } from '../middleware/validation.js';
import { InvalidCredentialsError, UserNotFoundError } from '../errors/index.js';
import { writeOrLog } from '../lib/auditLog.js';
import { AuditAction } from '../lib/auditActions.js';
import { mailer, emailChangeUrl } from '../lib/mailer.js';
import { verificationEmailFailuresTotal } from '../middleware/metrics.js';
import { blindIndex } from '../lib/crypto/fieldCrypto.js';
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

// PATCH profile: display name. No credential check — a name change is not
// credential-sensitive. Email is a separate endpoint (below) with its own
// unconditional re-auth, so this handler never gates a security check on
// request data.
router.patch(
  '/me',
  auth,
  writeLimiter,
  validate(schemas.updateProfile),
  async (req, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const userId = requireUserId(req);
    const { name } = req.body as { name: string };

    const updated = await UserService.updateProfile(userId, { name });
    log.info({ userId }, 'User display name updated');
    res.json(updated);
  },
);

// PATCH email: credential-sensitive, so it re-authenticates with the current
// password. Verification is unconditional — both fields are required by the
// schema — so there is no request-controlled path that skips the check.
//
// The password proves who is asking; it proves nothing about the address being
// asked for. So this stages the change and mails a token to the new address —
// redeeming it (POST /auth/verify-email-change) is what moves the account.
// Until then the current address stays live, which is what makes a typo
// recoverable instead of an instant self-lockout.
//
// Responds 202 with a fixed body whether or not the address is already taken:
// an authenticated user could otherwise walk addresses through this endpoint and
// read account existence off the status code. A taken address simply never
// yields a usable token (redemption re-checks and refuses).
router.patch(
  '/me/email',
  auth,
  writeLimiter,
  emailChangeLimiter,
  validate(schemas.changeEmail),
  async (req, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const userId = requireUserId(req);
    const { email, currentPassword } = req.body as { email: string; currentPassword: string };

    const ok = await UserService.verifyPassword(userId, currentPassword);
    if (!ok) throw new InvalidCredentialsError();

    const rawToken = await EmailChangeTokenService.issue(userId, email);

    // Fire-and-forget for the same reason registration is: awaiting a
    // third-party HTTP call would make this endpoint's latency depend on the
    // provider, and a send failure must not roll back a request the user can
    // simply repeat.
    void mailer
      .sendEmailChangeVerification({ to: email, verifyUrl: emailChangeUrl(rawToken) })
      .catch((err: unknown) => {
        verificationEmailFailuresTotal.inc();
        log.error({ err, userId }, 'Email-change verification failed to send');
      });

    void writeOrLog(
      prisma,
      {
        action: AuditAction.UserEmailChangeRequested,
        outcome: 'success',
        entityType: 'User',
        entityId: userId,
        changedBy: userId,
        // Blind index only — audit_entries JSONB is neither redacted nor
        // encrypted, so a raw address here would be PII at rest.
        newValue: { emailHash: blindIndex(email) },
      },
      log,
    );

    log.info({ userId }, 'Email change requested; verification dispatched to the new address');
    res.status(202).json({
      message: 'Check the new address for a confirmation link. Your current email is unchanged.',
    });
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
// exportLimiter (5/hour/user), not readLimiter: this handler loads the caller's
// entire todo history into memory, so the cost is in replaying it, not in any
// single response. The global per-IP limiter still backstops it.
router.get('/me/export', auth, exportLimiter, async (req, res: Response): Promise<void> => {
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
