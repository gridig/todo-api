import express, { Response, Router } from 'express';
import type { Logger } from 'pino';
import UserService, { DUMMY_PASSWORD_HASH } from '../models/User.js';
import RefreshTokenService from '../models/RefreshToken.js';
import EmailVerificationTokenService from '../models/EmailVerificationToken.js';
import { signAccessToken } from '../lib/tokens.js';
import { blindIndex } from '../lib/crypto/fieldCrypto.js';
import { mailer, verificationUrl } from '../lib/mailer.js';
import { verificationEmailFailuresTotal } from '../middleware/metrics.js';
import {
  authLimiter,
  loginEmailLimiter,
  loginIpLimiter,
  registerLimiter,
  refreshLimiter,
  resendVerificationLimiter,
  verifyEmailLimiter,
  writeLimiter,
} from '../middleware/rateLimiter.js';
import { validate, schemas } from '../middleware/validation.js';
import { auth, requireUserId } from '../middleware/auth.js';
import {
  DuplicateEmailError,
  EmailNotVerifiedError,
  InvalidCredentialsError,
  InvalidTokenError,
  InvalidVerificationTokenError,
} from '../errors/index.js';
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

// Identical for a fresh address and one that is already registered. Register no
// longer returns tokens: an account is inert until POST /auth/verify redeems the
// emailed token, which is what removes the account-existence oracle (SCRUTINY.md
// M3) and stops an attacker squatting someone else's address.
const REGISTRATION_ACCEPTED = {
  message: 'If that address can be registered, a verification email has been sent.',
} as const;

// Issue a single-use token and dispatch the mail. The send is fire-and-forget on
// purpose: awaiting a third-party HTTP call would make the "new address" branch
// measurably slower than the "already registered" branch and hand back the
// timing oracle we just closed. Failures are logged and counted, never surfaced.
async function sendVerification(userId: string, email: string, log: Logger): Promise<void> {
  const rawToken = await EmailVerificationTokenService.issue(userId);

  void mailer
    .sendVerificationEmail({ to: email, verifyUrl: verificationUrl(rawToken) })
    .catch((err: unknown) => {
      verificationEmailFailuresTotal.inc();
      log.error({ err, userId }, 'Verification email failed to send');
    });

  void writeOrLog(
    prisma,
    {
      action: AuditAction.AuthEmailVerificationSent,
      outcome: 'success',
      entityType: 'User',
      entityId: userId,
      changedBy: userId,
    },
    log,
  );
}

router.post(
  '/register',
  registerLimiter,
  validate(schemas.register),
  async (req, res: Response<AuthRouteResponse>): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const { email, password } = req.body as RegisterRequest;

    // The duplicate branch still pays the bcrypt cost inside UserService.create
    // before the insert fails, so both paths do the same dominant work.
    let user: Awaited<ReturnType<typeof UserService.create>> | null = null;
    try {
      user = await UserService.create({ email, password });
    } catch (err: unknown) {
      if (!(err instanceof DuplicateEmailError)) throw err;
      log.info('Registration attempted for an address that already exists');
    }

    if (user) {
      await sendVerification(user.id, user.email, log);
      log.info({ userId: user.id }, 'User registered, verification email dispatched');
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
    }

    res.status(202).json(REGISTRATION_ACCEPTED);
  },
);

// Redeem a verification token. Distinguishing expired/already-used from invalid
// is safe here and materially better UX — the token is 256-bit random, so the
// distinction is only available to someone who already holds a real token.
router.post(
  '/verify',
  verifyEmailLimiter,
  validate(schemas.verifyEmail),
  async (req, res: Response<AuthRouteResponse>): Promise<void> => {
    const { log, id: requestId } = req as RequestWithLogger;
    const { token } = req.body as { token: string };

    const result = await EmailVerificationTokenService.verify(token);

    if (result.status !== 'verified') {
      log.warn({ reason: result.status }, 'Email verification failed');
      void writeOrLog(
        prisma,
        {
          action: AuditAction.AuthEmailVerify,
          outcome: 'failure',
          outcomeReason: result.status,
        },
        log,
      );
      const error = new InvalidVerificationTokenError(result.status);
      res.status(error.statusCode).json({ ...error.toJSON(), requestId });
      return;
    }

    log.info({ userId: result.userId }, 'Email address verified');
    void writeOrLog(
      prisma,
      {
        action: AuditAction.AuthEmailVerify,
        outcome: 'success',
        entityType: 'User',
        entityId: result.userId,
        changedBy: result.userId,
      },
      log,
    );
    res.status(200).json({ message: 'Email verified. You can now log in.' });
  },
);

// Always 202 with the same body, for the same reason register is: a per-address
// response would re-open the oracle from a different endpoint.
router.post(
  '/resend-verification',
  resendVerificationLimiter,
  validate(schemas.resendVerification),
  async (req, res: Response<AuthRouteResponse>): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const { email } = req.body as { email: string };

    const user = await UserService.findByEmail(email);
    // Verified accounts get nothing: re-sending would let anyone mail-bomb a
    // known-good address, and there is nothing left to verify.
    if (user && user.emailVerifiedAt === null) {
      await sendVerification(user.id, user.email, log);
    }

    res.status(202).json(REGISTRATION_ACCEPTED);
  },
);

// loginIpLimiter runs first: it is the cheap IP-only check, so stuffing traffic
// is rejected before authLimiter's key generator spends an HMAC on the email.
router.post(
  '/login',
  loginIpLimiter,
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

    // Gate on verification only AFTER the password check. Checking earlier
    // would turn this into the enumeration oracle the register flow no longer
    // is — as written, the distinct 403 is visible only to someone who already
    // holds valid credentials for the account.
    if (user.emailVerifiedAt === null) {
      log.warn({ userId: user.id }, 'Login refused - email not verified');
      void writeOrLog(
        prisma,
        {
          action: AuditAction.AuthLogin,
          outcome: 'failure',
          outcomeReason: 'email-not-verified',
          entityType: 'User',
          entityId: user.id,
          changedBy: user.id,
        },
        log,
      );
      const error = new EmailNotVerifiedError();
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
