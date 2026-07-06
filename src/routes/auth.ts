import express, { Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import UserService, { DUMMY_PASSWORD_HASH, normalizeEmail } from '../models/User.js';
import { env } from '../config/env.js';
import { authLimiter, loginEmailLimiter, registerLimiter } from '../middleware/rateLimiter.js';
import { validate, schemas } from '../middleware/validation.js';
import { InvalidCredentialsError } from '../errors/index.js';
import { writeOrLog } from '../lib/auditLog.js';
import { AuditAction } from '../lib/auditActions.js';
import prisma from '../lib/prisma.js';
import type {
  RegisterRequest,
  LoginRequest,
  AuthRouteResponse,
  JWTPayload,
  RequestWithLogger,
} from '../types/index.js';

// Hash the canonical form (NFC + lowercase + trim, same as storage and the
// rate-limit key) so audit emailHash values correlate across Unicode variants.
// Exported for the canonicalization unit test.
export const hashEmail = (email: string): string =>
  createHash('sha256').update(normalizeEmail(email)).digest('hex');

const router: Router = express.Router();

router.post(
  '/register',
  registerLimiter,
  validate(schemas.register),
  async (req, res: Response<AuthRouteResponse>): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const { email, password } = req.body as RegisterRequest;

    const user = await UserService.create({ email, password });
    const payload: JWTPayload = { sub: user.id };
    const token = jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: '24h',
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });

    log.info({ userId: user.id, email: user.email }, 'User registered successfully');
    void writeOrLog(
      prisma,
      {
        action: AuditAction.AuthRegister,
        outcome: 'success',
        entityType: 'User',
        entityId: user.id,
        changedBy: user.id,
        newValue: { id: user.id, email: user.email },
      },
      log,
    );
    res.status(201).json({ token });
  },
);

router.post(
  '/login',
  authLimiter,
  loginEmailLimiter,
  validate(schemas.login),
  async (req, res: Response<AuthRouteResponse>): Promise<void> => {
    const { log, id: requestId } = req as RequestWithLogger;
    const { email, password } = req.body as LoginRequest;

    const user = await UserService.findByEmail(email);

    // Always run bcrypt — even when the user does not exist — to equalize
    // CPU work between the two branches. Without this, an attacker can
    // enumerate registered emails by measuring login response time
    // (~80ms hash vs near-instant DB miss). See security-audit-2026-05-18.md.
    const candidateHash = user?.password ?? DUMMY_PASSWORD_HASH;
    const isMatch = await UserService.comparePassword(password, candidateHash);

    if (!user || !isMatch) {
      // Both branches log the same shape — deliberately. Recording whether
      // the user existed (via `reason` or the presence of `userId`/`email`)
      // is the same enumeration oracle the dummy-hash flow above removes
      // for clients; the log line must not reintroduce it for log readers.
      log.warn(
        {
          ip: req.ip,
          userAgent: req.get('user-agent'),
        },
        'Login failed - invalid credentials',
      );
      // Hash the email rather than store it raw — preserves the dummy-hash
      // anti-enumeration property so the audit table isn't itself an oracle.
      void writeOrLog(
        prisma,
        {
          action: AuditAction.AuthLogin,
          outcome: 'failure',
          outcomeReason: 'invalid-credentials',
          metadata: { emailHash: hashEmail(email) },
        },
        log,
      );
      const error = new InvalidCredentialsError();
      res.status(error.statusCode).json({ ...error.toJSON(), requestId });
      return;
    }

    // Opportunistic password rehash at the current SALT_ROUNDS for legacy
    // cost-10 (or lower) hashes. Fire-and-forget — must not block the
    // response. Failure is non-fatal: the next successful login retries.
    if (UserService.needsRehash(user.password)) {
      void UserService.updatePassword(user.id, password).catch((err: unknown) => {
        log.warn({ err, userId: user.id }, 'Password rehash failed, will retry on next login');
      });
    }

    const payload: JWTPayload = { sub: user.id };
    const token = jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: '24h',
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });

    log.info({ userId: user.id, email: user.email }, 'User logged in successfully');
    void writeOrLog(
      prisma,
      {
        action: AuditAction.AuthLogin,
        outcome: 'success',
        entityType: 'User',
        entityId: user.id,
        changedBy: user.id,
      },
      log,
    );
    res.status(200).json({ token });
  },
);

export default router;
