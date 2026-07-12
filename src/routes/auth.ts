import express, { Response, Router } from 'express';
import type { Logger } from 'pino';
import UserService, { DUMMY_PASSWORD_HASH } from '../models/User.js';
import RefreshTokenService from '../models/RefreshToken.js';
import { signAccessToken } from '../lib/tokens.js';
import { blindIndex } from '../lib/crypto/fieldCrypto.js';
import {
  authLimiter,
  loginEmailLimiter,
  registerLimiter,
  refreshLimiter,
  writeLimiter,
} from '../middleware/rateLimiter.js';
import { validate, schemas } from '../middleware/validation.js';
import { auth, requireUserId } from '../middleware/auth.js';
import { InvalidCredentialsError, InvalidTokenError } from '../errors/index.js';
import { writeOrLog } from '../lib/auditLog.js';
import { AuditAction } from '../lib/auditActions.js';
import prisma from '../lib/prisma.js';
import type {
  RegisterRequest,
  LoginRequest,
  AuthRouteResponse,
  RequestWithLogger,
} from '../types/index.js';

// Audit-facing email hash. Delegates to the keyed blind index (HMAC over the
// canonical NFC+lowercase+trim form) — the same value stored in
// users.email_hash — so failed-login audit rows correlate to an account across
// Unicode variants without ever recording the raw address, and are not an
// offline-enumerable oracle (keyed, unlike a bare SHA-256). Exported for the
// canonicalization unit test.
export const hashEmail = (email: string): string => blindIndex(email);

// Shared theft response: a revoked refresh token (or a lost rotation race)
// means the token may be in an attacker's hands. Revoke the user's entire
// token set and record a security audit event. Fire-and-forget audit matches
// the rest of the auth flow — the 401 must not wait on the audit write.
async function revokeAllAndAuditReuse(userId: string, log: Logger): Promise<void> {
  await RefreshTokenService.revokeAllForUser(userId);
  log.warn({ userId }, 'Refresh token reuse detected — all sessions revoked');
  void writeOrLog(
    prisma,
    {
      action: AuditAction.AuthRefreshReuse,
      outcome: 'failure',
      outcomeReason: 'token-reuse',
      entityType: 'User',
      entityId: userId,
      changedBy: userId,
    },
    log,
  );
}

const router: Router = express.Router();

router.post(
  '/register',
  registerLimiter,
  validate(schemas.register),
  async (req, res: Response<AuthRouteResponse>): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const { email, password } = req.body as RegisterRequest;

    const user = await UserService.create({ email, password });
    const token = signAccessToken(user.id);
    const refreshToken = await RefreshTokenService.issue(user.id);

    log.info({ userId: user.id, email: user.email }, 'User registered successfully');
    void writeOrLog(
      prisma,
      {
        action: AuditAction.AuthRegister,
        outcome: 'success',
        entityType: 'User',
        entityId: user.id,
        changedBy: user.id,
        // Store the blind-index hash, not the raw address: audit_entries JSONB is
        // neither redacted (Pino redaction is log-only) nor encrypted, so a raw
        // email here would be PII at rest. entityId already identifies the user.
        newValue: { id: user.id, emailHash: hashEmail(user.email) },
      },
      log,
    );
    res.status(201).json({ token, refreshToken });
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

    const token = signAccessToken(user.id);
    const refreshToken = await RefreshTokenService.issue(user.id);

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
    res.status(200).json({ token, refreshToken });
  },
);

// Exchange a refresh token for a new access token + rotated refresh token.
// Rotation revokes the presented token on every use; replaying a
// already-revoked token (or losing the rotation race) is treated as theft and
// revokes the user's entire token set.
router.post(
  '/refresh',
  refreshLimiter,
  validate(schemas.refresh),
  async (req, res: Response<AuthRouteResponse>): Promise<void> => {
    const { log, id: requestId } = req as RequestWithLogger;
    const { refreshToken } = req.body as { refreshToken: string };

    const result = await RefreshTokenService.verify(refreshToken);

    // Reuse/theft: a token that was already rotated or explicitly revoked is
    // being replayed. Revoke everything for the user and refuse.
    if (result.status === 'revoked') {
      await revokeAllAndAuditReuse(result.token.userId, log);
      const error = new InvalidTokenError();
      res.status(error.statusCode).json({ ...error.toJSON(), requestId });
      return;
    }

    // not_found / expired are indistinguishable to the client — generic 401.
    if (result.status !== 'valid') {
      const error = new InvalidTokenError();
      res.status(error.statusCode).json({ ...error.toJSON(), requestId });
      return;
    }

    const rotated = await RefreshTokenService.rotate(result.token);
    if (rotated === null) {
      // Lost the rotation race: the token was valid at verify time but was
      // rotated concurrently. Ambiguous between a benign double-submit and
      // genuine concurrent use — err toward security and revoke all.
      await revokeAllAndAuditReuse(result.token.userId, log);
      const error = new InvalidTokenError();
      res.status(error.statusCode).json({ ...error.toJSON(), requestId });
      return;
    }

    const token = signAccessToken(result.token.userId);
    void writeOrLog(
      prisma,
      {
        action: AuditAction.AuthRefresh,
        outcome: 'success',
        entityType: 'User',
        entityId: result.token.userId,
        changedBy: result.token.userId,
      },
      log,
    );
    res.status(200).json({ token, refreshToken: rotated });
  },
);

// Revoke the presented refresh token. Does not require a valid access token so
// a client with an expired access token can still log out. Always responds 200
// regardless of whether the token existed — no existence oracle.
router.post(
  '/logout',
  refreshLimiter,
  validate(schemas.logout),
  async (req, res): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const { refreshToken } = req.body as { refreshToken: string };

    const revoked = await RefreshTokenService.revoke(refreshToken);
    if (revoked) {
      void writeOrLog(prisma, { action: AuditAction.AuthLogout, outcome: 'success' }, log);
    }
    res.status(200).json({ message: 'Logged out' });
  },
);

// Revoke every active refresh token for the authenticated user (e.g. "sign out
// of all devices"). Requires a valid access token to identify the user.
router.post('/logout-all', writeLimiter, auth, async (req, res): Promise<void> => {
  const { log } = req as RequestWithLogger;
  const userId = requireUserId(req);

  const { count } = await RefreshTokenService.revokeAllForUser(userId);
  void writeOrLog(
    prisma,
    {
      action: AuditAction.AuthLogoutAll,
      outcome: 'success',
      entityType: 'User',
      entityId: userId,
      changedBy: userId,
      metadata: { revokedCount: count },
    },
    log,
  );
  res.status(200).json({ message: 'All sessions logged out', count });
});

export default router;
